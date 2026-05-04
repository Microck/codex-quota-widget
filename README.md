<h1 align="">codex-quota-widget</h1>

<p align="">
  tiny bridge + scriptable widget for merged codex quotas from cliproxyapi.
</p>

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

## ios widget

install Scriptable, paste `scriptable-widget.js`, and set:

```js
const QUOTA_URL = "http://100.x.y.z:8765/quota?token=<your-widget-token>";
```

then add a Scriptable widget to the home screen and select the script.

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

tokens, auth file paths, and the management password are not returned by the bridge.
