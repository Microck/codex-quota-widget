<h1 align="">codex-quota-widget</h1>

<p align="">
  tiny bridge + scriptable widget for merged codex quotas from cliproxyapi.
</p>

merge multiple codex accounts into one home-screen view with unified 5-hour and weekly quota windows.

![codex quota widget preview](assets/widget-preview.png)

---

## quick start

run the bridge on the machine that runs cliproxyapi:

```bash
git clone https://github.com/Microck/codex-quota-widget.git
cd codex-quota-widget

CLIPROXY_MANAGEMENT_KEY="your-management-password" \
CODEX_QUOTA_WIDGET_TOKEN="$(openssl rand -hex 18)" \
CODEX_QUOTA_WIDGET_HOST="127.0.0.1" \
node server.mjs
```

or create a local env file:

```bash
cp .env.example .env
$EDITOR .env
```

if your phone reaches the machine over tailscale, bind the bridge to that tailscale address:

```bash
CLIPROXY_MANAGEMENT_KEY="your-management-password" \
CODEX_QUOTA_WIDGET_TOKEN="<your-widget-token>" \
CODEX_QUOTA_WIDGET_HOST="100.x.y.z" \
node server.mjs
```

open:

```text
http://100.x.y.z:8765/quota?token=<your-widget-token>
```

---

## start at boot

install the systemd service on the machine that runs cliproxyapi:

```bash
cp .env.example .env
perl -0pi -e "s/replace-with-output-of-openssl-rand-hex-18/$(openssl rand -hex 18)/" .env
$EDITOR .env
./install-startup-service.sh
```

the installer writes `codex-quota-widget.service` to `/etc/systemd/system`, starts it immediately, and enables it for `multi-user.target`.

the generated service:

- reads bridge configuration from the ignored local `.env`
- starts after network ordering and `cliproxyapi.service`
- includes Tailscale ordering for hosts that bind to a Tailscale address
- restarts every 10 seconds if the bridge exits while dependencies finish starting

check it later with:

```bash
systemctl status codex-quota-widget.service --no-pager
```

---

## ios widget

install Scriptable, paste `scriptable-widget.js`, and set:

```js
const QUOTA_URL = "http://100.x.y.z:8765/quota?token=<your-widget-token>";
```

then add a Scriptable widget to the home screen and select the script.

the script asks ios to refresh the widget every 5 minutes. ios may still delay home-screen widget refreshes.

---

## what it reads

the bridge uses cliproxyapi management endpoints:

- `GET /v0/management/auth-files`
- `POST /v0/management/api-call`

for every enabled codex auth, it calls:

```text
https://chatgpt.com/backend-api/wham/usage
```

the widget shows merged 5-hour and weekly windows, ready/blocked account counts, and refill times.
if the usage response includes a separate `GPT-5.3-Codex-Spark` quota under
`additional_rate_limits`, the bridge returns it as a separate optional `spark`
summary and the widget shows it only for accounts that actually report that quota.

tokens, auth file paths, and the management password are not returned by the bridge.
