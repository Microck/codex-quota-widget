import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

function jwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

test("single-account mode refreshes Codex auth and reads usage without CLIProxyAPI", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-quota-widget-"));
  const authFile = path.join(tempDir, "auth.json");
  const requests = [];

  await writeFile(
    authFile,
    JSON.stringify({
      auth_mode: "apikey",
      email: "user@example.com",
      tokens: {
        access_token: "expired-access",
        refresh_token: "old-refresh",
        account_id: "acct_123",
        id_token: jwt({ exp: Math.floor(Date.now() / 1000) - 60, email: "user@example.com" }),
      },
    }),
  );

  const upstream = http.createServer(async (request, response) => {
    if (request.url === "/oauth/token") {
      const form = new URLSearchParams(await readRequestBody(request));
      requests.push({ kind: "refresh", form });
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "old-refresh");
      sendJson(response, 200, {
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        id_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: "user@example.com" }),
      });
      return;
    }

    if (request.url === "/usage") {
      requests.push({
        kind: "usage",
        authorization: request.headers.authorization,
        accountId: request.headers["chatgpt-account-id"],
      });
      sendJson(response, 200, {
        email: "user@example.com",
        plan_type: "plus",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 25,
            reset_at: 1893456000,
            limit_window_seconds: 18000,
          },
          secondary_window: {
            used_percent: 50,
            reset_at: 1894060800,
            limit_window_seconds: 604800,
          },
        },
      });
      return;
    }

    sendJson(response, 404, { error: "not found" });
  });

  const port = await listen(upstream);
  const oldEnv = { ...process.env };
  process.env.CODEX_AUTH_FILE = authFile;
  process.env.CODEX_OAUTH_TOKEN_URL = `http://127.0.0.1:${port}/oauth/token`;
  process.env.CODEX_USAGE_URL = `http://127.0.0.1:${port}/usage`;
  delete process.env.CLIPROXY_MANAGEMENT_KEY;

  try {
    const moduleUrl = `../server.mjs?test=${Date.now()}`;
    const { buildQuotaSnapshot } = await import(moduleUrl);
    const snapshot = await buildQuotaSnapshot();

    assert.equal(snapshot.source, "codex-auth-file -> chatgpt.com/backend-api/wham/usage");
    assert.equal(snapshot.accountCount, 1);
    assert.equal(snapshot.readyAccountCount, 1);
    assert.equal(snapshot.errorCount, 0);
    assert.equal(snapshot.windows.fiveHour.remainingPercent, 75);
    assert.equal(snapshot.windows.weekly.remainingPercent, 50);
    assert.deepEqual(
      requests.map((request) => request.kind),
      ["refresh", "usage"],
    );
    assert.equal(requests[1].authorization, "Bearer fresh-access");
    assert.equal(requests[1].accountId, "acct_123");

    const refreshedAuth = JSON.parse(await readFile(authFile, "utf8"));
    assert.equal(refreshedAuth.tokens.access_token, "fresh-access");
    assert.equal(refreshedAuth.tokens.refresh_token, "fresh-refresh");
  } finally {
    process.env = oldEnv;
    await new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    await rm(tempDir, { recursive: true, force: true });
  }
});
