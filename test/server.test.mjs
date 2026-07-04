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
  const soonResetExpiryAt = new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString();
  const laterResetExpiryAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();

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

    if (request.url === "/reset-credits") {
      requests.push({
        kind: "reset-credits",
        authorization: request.headers.authorization,
        accountId: request.headers["chatgpt-account-id"],
      });
      sendJson(response, 200, {
        available_count: 2,
        credits: [
          {
            id: 123,
            reset_type: "rate_limit",
            status: "available",
            expires_at: soonResetExpiryAt,
            title: "One free rate limit reset",
          },
          {
            status: "available",
            expires_at: laterResetExpiryAt,
          },
          {
            id: "credit-2",
            reset_type: "rate_limit",
            status: "redeemed",
          },
        ],
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
  process.env.CODEX_RESET_CREDITS_URL = `http://127.0.0.1:${port}/reset-credits`;
  delete process.env.CLIPROXY_MANAGEMENT_KEY;

  try {
    const moduleUrl = `../server.mjs?test=${Date.now()}`;
    const { buildQuotaSnapshot } = await import(moduleUrl);
    const snapshot = await buildQuotaSnapshot();

    assert.equal(snapshot.source, "codex-auth-file -> chatgpt.com/backend-api/wham/{usage,rate-limit-reset-credits}");
    assert.equal(snapshot.accountCount, 1);
    assert.equal(snapshot.readyAccountCount, 1);
    assert.equal(snapshot.errorCount, 0);
    assert.equal(snapshot.windows.fiveHour.remainingPercent, 75);
    assert.equal(snapshot.windows.weekly.remainingPercent, 50);
    assert.equal(snapshot.resetCredits.availableCount, 2);
    assert.equal(snapshot.resetCredits.creditCount, 2);
    assert.equal(snapshot.resetCredits.urgentCount, 1);
    assert.equal(snapshot.resetCredits.nextExpiryAt, soonResetExpiryAt);
    assert.equal(snapshot.accounts[0].resetCredits.availableCount, 2);
    assert.equal(snapshot.accounts[0].resetCredits.credits[0].id, "123");
    assert.equal(snapshot.nudge.tier, "expiringReset");
    assert.equal(snapshot.nudge.title, "Use it or lose it");
    assert.deepEqual(
      requests.map((request) => request.kind),
      ["refresh", "usage", "reset-credits"],
    );
    assert.equal(requests[1].authorization, "Bearer fresh-access");
    assert.equal(requests[1].accountId, "acct_123");
    assert.equal(requests[2].authorization, "Bearer fresh-access");
    assert.equal(requests[2].accountId, "acct_123");

    const refreshedAuth = JSON.parse(await readFile(authFile, "utf8"));
    assert.equal(refreshedAuth.tokens.access_token, "fresh-access");
    assert.equal(refreshedAuth.tokens.refresh_token, "fresh-refresh");
  } finally {
    process.env = oldEnv;
    await new Promise((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("reset urgency follows the reset watcher boundaries", async () => {
  const { makeResetExpiryUrgency } = await import(`../server.mjs?urgency=${Date.now()}`);
  const now = Date.parse("2027-01-15T08:00:00.000Z");
  const after = (seconds) => new Date(now + seconds * 1000).toISOString();

  assert.equal(makeResetExpiryUrgency({ expiresAt: after(7 * 86_400 + 1), isAvailable: true, now }).level, "normal");
  assert.equal(makeResetExpiryUrgency({ expiresAt: after(7 * 86_400), isAvailable: true, now }).level, "approaching");
  assert.equal(makeResetExpiryUrgency({ expiresAt: after(3 * 86_400), isAvailable: true, now }).level, "soon");
  assert.equal(makeResetExpiryUrgency({ expiresAt: after(86_400), isAvailable: true, now }).level, "urgent");
  assert.equal(makeResetExpiryUrgency({ expiresAt: after(0), isAvailable: true, now }).level, "expired");
  assert.equal(makeResetExpiryUrgency({ expiresAt: after(30 * 60), isAvailable: false, now }).level, "inactive");
  assert.equal(makeResetExpiryUrgency({ expiresAt: null, isAvailable: true, now }).level, "unknown");
});

test("usage nudge ports reset watcher advice rules", async () => {
  const { makeUsageNudge } = await import(`../server.mjs?nudge=${Date.now()}`);

  assert.equal(
    makeUsageNudge({
      weekly: { remainingPercent: 10, resetAfterSeconds: 5 * 86_400 },
      resetCount: 2,
    }).tier,
    "spend",
  );
  assert.equal(
    makeUsageNudge({
      fiveHour: { remainingPercent: 5, resetAfterSeconds: 60 * 60 },
      weekly: { remainingPercent: 80, resetAfterSeconds: 5 * 86_400 },
      resetCount: 1,
    }).tier,
    "waitFiveHour",
  );
  assert.equal(
    makeUsageNudge({
      fiveHour: { remainingPercent: 5, resetAfterSeconds: 4 * 3_600 },
      weekly: { remainingPercent: 80, resetAfterSeconds: 5 * 86_400 },
      resetCount: 1,
    }).tier,
    "deadline",
  );
  assert.equal(
    makeUsageNudge({
      weekly: { remainingPercent: 40, resetAfterSeconds: 2 * 86_400 },
      resetCount: 2,
    }).tier,
    "hold",
  );
  assert.equal(
    makeUsageNudge({
      weekly: { remainingPercent: 40, resetAfterSeconds: null },
      resetCount: 1,
    }).tier,
    "steady",
  );
  assert.equal(
    makeUsageNudge({
      weekly: { remainingPercent: 40, resetAfterSeconds: 2 * 86_400 },
      resetCount: null,
    }).title,
    "Reset credits unavailable",
  );
});
